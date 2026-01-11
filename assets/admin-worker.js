const fs = require('fs');
const path = require('path');

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
      if (actionArgs.length < 2) throw new Error('Missing args');
      fs.cpSync(actionArgs[0], actionArgs[1], { recursive: true, force: true });
      break;
    case 'move':
      if (actionArgs.length < 2) throw new Error('Missing args');
      try {
        fs.renameSync(actionArgs[0], actionArgs[1]);
      } catch {
        fs.cpSync(actionArgs[0], actionArgs[1], { recursive: true, force: true });
        fs.rmSync(actionArgs[0], { recursive: true, force: true });
      }
      break;
    case 'delete':
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
