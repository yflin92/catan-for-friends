// Test double for `docker` in tooling/gamenight-preflight.test.ts. Logs its arguments to DOCKER_LOG. `image inspect`
// succeeds for the images listed in FAKE_IMAGES. `run` stands in for a container: it runs the `node …` command with the
// real Node (FAKE_NODE), sees host paths only through the -v mounts (container paths in arguments and -w are mapped
// back to their host paths), and gets only the environment variables named with -e. Each `--add-host <name>:host-gateway`
// makes <name> resolve to 127.0.0.1 inside it (gamenight-preflight.fake-hosts.mjs); other names resolve as usual.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
appendFileSync(process.env.DOCKER_LOG, `${args.join(' ')}\n`);
if (args[0] === 'image' && args[1] === 'inspect') {
  process.exit((process.env.FAKE_IMAGES ?? '').split(',').includes(args[2]) ? 0 : 1);
}
if (args[0] !== 'run') process.exit(125);
const mounts = [];
const env = {};
const addHosts = [];
let cwd = '/';
let i = 1;
for (; i < args.length; i++) {
  const a = args[i];
  if (a === '--rm') continue;
  if (a === '--user') i++;
  else if (a === '-e') {
    const name = args[++i];
    if (name.includes('=')) process.exit(126);
    if (process.env[name] !== undefined) env[name] = process.env[name];
  } else if (a === '-v') {
    const [host, container, mode] = args[++i].split(':');
    mounts.push({ host, container, mode });
  } else if (a === '--add-host') {
    const [name, target] = args[++i].split(':');
    if (target !== 'host-gateway') process.exit(125);
    addHosts.push(name);
  } else if (a === '-w') cwd = args[++i];
  else break;
}
const toHost = (p) => {
  const m = mounts
    .filter((x) => p === x.container || p.startsWith(`${x.container}/`))
    .sort((a, b) => b.container.length - a.container.length)[0];
  return m ? m.host + p.slice(m.container.length) : p;
};
const command = args.slice(i + 1);
if (command[0] !== 'node') process.exit(127);
const hosts = fileURLToPath(new URL('./gamenight-preflight.fake-hosts.mjs', import.meta.url));
const nodeArgs = addHosts.length > 0 ? ['--import', hosts, ...command.slice(1).map(toHost)] : command.slice(1).map(toHost);
const r = spawnSync(process.env.FAKE_NODE, nodeArgs, { cwd: toHost(cwd), env: { ...env, FAKE_ADD_HOSTS: addHosts.join(',') }, stdio: 'inherit' });
process.exit(r.status ?? 1);
