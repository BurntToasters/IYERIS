import * as path from 'path';
import { app } from 'electron';

const sudo = require('sudo-prompt');

export async function runElevated(action: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let workerPath: string;
    
    if (app.isPackaged) {
        workerPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'admin-worker.js');
    } else {
        workerPath = path.join(__dirname, '../../assets/admin-worker.js');
    }

    const options = {
      name: 'Iyeris'
    };

    const allArgs = [action, ...args];
    const encodedArgs = allArgs.map(arg => `"${Buffer.from(arg).toString('base64')}"`).join(' ');
    
    let command: string;
    
    const execPath = process.execPath;
    
    if (process.platform === 'win32') {
         command = `set ELECTRON_RUN_AS_NODE=1 && "${execPath}" "${workerPath}" ${encodedArgs}`;
    } else {
         command = `ELECTRON_RUN_AS_NODE=1 "${execPath}" "${workerPath}" ${encodedArgs}`;
    }

    sudo.exec(command, options, (error: Error | undefined, stdout: string | undefined, stderr: string | undefined) => {
      if (error) {
        reject(error || new Error(stderr as string));
      } else {
        resolve();
      }
    });
  });
}
