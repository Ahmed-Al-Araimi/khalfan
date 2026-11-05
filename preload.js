'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  onTick: (fn) => ipcRenderer.on('tick', (e, d) => fn(d)),
  onWorld: (fn) => ipcRenderer.on('world', (e, d) => fn(d)),
  onEvent: (fn) => ipcRenderer.on('event', (e, d) => fn(d)),
  onSettings: (fn) => ipcRenderer.on('settings', (e, d) => fn(d)),
  onVisible: (fn) => ipcRenderer.on('visible', (e, d) => fn(d)),
  settings: () => ipcRenderer.invoke('settings'),
  firstWorld: () => ipcRenderer.invoke('first-world'),
  interactive: (on, box, dragging) => ipcRenderer.send('interactive', on, box, dragging),
  track: (hwnd) => ipcRenderer.send('track', hwnd || 0),
  pace: (fast) => ipcRenderer.send('pace', !!fast),
  menu: () => ipcRenderer.send('menu'),
  gone: () => ipcRenderer.send('gone'),
  trayIcon: (url) => ipcRenderer.send('tray-icon', url),
  rageShot: (hwnd) => ipcRenderer.send('rage-shot', hwnd),              // his ultra rage: a picture of the window he will strike
  rageBurn: (hwnd) => ipcRenderer.send('rage-burn', hwnd),              // ...and, at the hit, that window minimized (never closed)
  onRage: (fn) => ipcRenderer.on('rage', (e, d) => fn(d)),
  reviewSheet: (name, url) => ipcRenderer.send('review-sheet', name, url),
  reviewFrame: (name, i, url) => ipcRenderer.send('review-frame', name, i, url),
  reviewFile: (file, url) => ipcRenderer.send('review-file', file, url),
  reviewDone: () => ipcRenderer.send('review-done'),
  log: (...a) => ipcRenderer.send('log', ...a),
});

