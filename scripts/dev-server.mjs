import { spawn } from 'node:child_process';

const env = {
  ...process.env,
  NODE_OPTIONS: appendNodeOption(process.env.NODE_OPTIONS, '--use-env-proxy')
};

const child = spawn('node', ['node_modules/tsx/dist/cli.mjs', 'watch', 'server/index.ts'], {
  cwd: process.cwd(),
  env,
  shell: true,
  stdio: 'inherit'
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));

function appendNodeOption(current, option) {
  if (!current) {
    return option;
  }

  return current.includes(option) ? current : `${current} ${option}`;
}
