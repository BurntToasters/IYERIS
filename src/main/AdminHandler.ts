import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

// No types available for sudo-prompt
const sudo = require('sudo-prompt');

const WORKER_SCRIPT = `
const fs = require('fs');
const path = require('path');

// Decode base64 args
const args = process.argv.slice(2).map(arg => {
  try {
    return Buffer.from(arg, 'base64').toString('utf8');
  } catch {
    return arg;
  }
});

const action = args[0];
const actionArgs = args.slice(1);

try {
  switch (action) {
    case 'copy':
      // args: src, dest
      if (actionArgs.length < 2) throw new Error('Missing args');
      fs.cpSync(actionArgs[0], actionArgs[1], { recursive: true, force: true });
      break;
    case 'move':
       // args: src, dest
      if (actionArgs.length < 2) throw new Error('Missing args');
      try {
        fs.renameSync(actionArgs[0], actionArgs[1]);
      } catch {
        fs.cpSync(actionArgs[0], actionArgs[1], { recursive: true, force: true });
        fs.rmSync(actionArgs[0], { recursive: true, force: true });
      }
      break;
    case 'delete':
      // args: target
      if (actionArgs.length < 1) throw new Error('Missing args');
      fs.rmSync(actionArgs[0], { recursive: true, force: true });
      break;
    case 'createFolder':
       if (actionArgs.length < 1) throw new Error('Missing args');
       fs.mkdirSync(actionArgs[0], { recursive: true });
       break;
    case 'createFile':
       if (actionArgs.length < 1) throw new Error('Missing args');
       fs.writeFileSync(actionArgs[0], '');
       break;
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
`;

export async function runElevated(action: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(app.getPath('userData'), 'admin-worker.js');
    try {
        fs.writeFileSync(workerPath, WORKER_SCRIPT);
    } catch (e) {
        return reject(new Error('Failed to write admin worker: ' + e));
    }

    const options = {
      name: 'Iyeris'
    };
    
    // Base64 encode all arguments to prevent shell injection/parsing issues
    // We encode [action, ...args] so ALL command line components are just safe base64 strings
    const allArgs = [action, ...args];
    const encodedArgs = allArgs.map(arg => `"${Buffer.from(arg).toString('base64')}"`).join(' ');
    
    let command: string;
    
    // In dev mode, process.execPath is the electron binary
    // In prod, it's the app executable
    // Both support ELECTRON_RUN_AS_NODE=1
    
    const execPath = process.execPath;
    
    if (process.platform === 'win32') {
         command = `set ELECTRON_RUN_AS_NODE=1 && "${execPath}" "${workerPath}" ${encodedArgs}`;
    } else {
         command = `ELECTRON_RUN_AS_NODE=1 "${execPath}" "${workerPath}" ${encodedArgs}`;
    }

    sudo.exec(command, options, (error: Error | undefined, stdout: string | undefined, stderr: string | undefined) => {
      // Cleanup happens automatically or overwrites next time
      if (error) {
        reject(error || new Error(stderr as string));
      } else {
        resolve();
      }
    });
  });
}
