import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Status, TrailApi } from '../core/api.ts';

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
  listMaps: () => call('listMaps'),
  pickMap: () => call('pickMap'),
  addDroppedMap: (f) => call('addMapPath', webUtils.getPathForFile(f)),
  renameMap: (id, n) => call('renameMap', id, n),
  removeMap: (id) => call('removeMap', id),
  getSaved: () => call('getSaved'),
  saveLayers: (l) => call('saveLayers', l),
  saveView: (v) => call('saveView', v),
};
contextBridge.exposeInMainWorld('trail', api);
