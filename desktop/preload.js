'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('klmNative', {
  info: () => ipcRenderer.invoke('info'),
  kvSet: (k, v) => ipcRenderer.invoke('kv-set', k, v),
  fileOpen: (name) => ipcRenderer.invoke('file-open', name),
  fileWrite: (id, data) => ipcRenderer.invoke('file-write', id, data),
  fileClose: (id) => ipcRenderer.invoke('file-close', id),
  fileAbort: (id) => ipcRenderer.invoke('file-abort', id),
  hubSink: (tid, name) => ipcRenderer.invoke('hub-sink', tid, name),
  hubCancel: (tid) => ipcRenderer.invoke('hub-cancel', tid),
  chooseDir: () => ipcRenderer.invoke('choose-dir'),
  openDir: () => ipcRenderer.invoke('open-dir'),
  openFile: (p) => ipcRenderer.invoke('open-file', p),
  showFile: (p) => ipcRenderer.invoke('show-file', p),
  notify: (title, body) => ipcRenderer.invoke('notify', title, body),
  progress: (v) => ipcRenderer.send('progress', v)
});
