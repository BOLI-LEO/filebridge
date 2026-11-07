'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('filebridge', {
  isElectron: true,
  platform: process.platform,
  getState: () => ipcRenderer.invoke('float:get-state'),
  setExpanded: (expanded, height) => ipcRenderer.invoke('float:set-expanded', Boolean(expanded), Number(height) || 420),
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),
  dragStart: () => ipcRenderer.invoke('float:drag-start'),
  dragEnd: () => ipcRenderer.invoke('float:drag-end'),
  openMain: () => ipcRenderer.send('float:open-main'),
  openSettings: () => ipcRenderer.send('float:open-settings'),
  onOpenSettings: (callback) => ipcRenderer.on('ui:open-settings', () => callback()),
});
