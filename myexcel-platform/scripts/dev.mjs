import { spawn } from 'node:child_process';

const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [
  spawn(executable, ['run', 'dev:api'], { stdio: 'inherit', shell: false }),
  spawn(executable, ['run', 'dev:web'], { stdio: 'inherit', shell: false }),
];

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(exitCode), 300).unref();
}

for (const child of children) {
  child.on('exit', (code) => {
    if (!stopping && code) stop(code);
  });
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
