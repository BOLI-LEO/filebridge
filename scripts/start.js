#!/usr/bin/env node
'use strict';

// 某些环境会设置 ELECTRON_RUN_AS_NODE=1，会让 Electron 以纯 Node 模式启动，
// 导致 app 未定义。这里显式去掉该变量再启动。
const { spawn } = require('child_process');
const path = require('path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const electronBin = require('electron');
const child = spawn(electronBin, [path.resolve(__dirname, '..')], {
  stdio: 'inherit',
  env,
});

child.on('exit', (code) => process.exit(code == null ? 0 : code));
