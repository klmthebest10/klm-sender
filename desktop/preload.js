'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('klmNative', {
  info: () => ipcRenderer.invoke('info'),
  fileOpen: (name) => ipcRenderer.invoke('file-open', name),
  fileWrite: (id, data) => ipcRenderer.invoke('file-write', id, data),
  fileClose: (id) => ipcRenderer.invoke('file-close', id),
  fileAbort: (id) => ipcRenderer.invoke('file-abort', id),
  chooseDir: () => ipcRenderer.invoke('choose-dir'),
  openDir: () => ipcRenderer.invoke('open-dir'),
  openFile: (p) => ipcRenderer.invoke('open-file', p),
  showFile: (p) => ipcRenderer.invoke('show-file', p),
  notify: (title, body) => ipcRenderer.invoke('notify', title, body),
  progress: (v) => ipcRenderer.send('progress', v)
});
