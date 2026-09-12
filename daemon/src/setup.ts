// `npm run setup -- --host <tailnet IPv4>` — record the tailnet address the daemon should also bind
// (PLAN M8 T8.2; the installer calls this). Since M9 there is no secret to create.
//
// Prints the host and exits 1 on a host `readExtraHost` would refuse, so the installer fails loudly
// instead of leaving a daemon that only answers on loopback.
import { CONFIG_PATH, relayBase, writeExtraHost } from './config.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--host');
const host = at === -1 ? undefined : args[at + 1];

if (host === undefined) {
  console.log(`quotalens: no --host given; the daemon stays loopback-only (${CONFIG_PATH} unchanged)`);
} else if (writeExtraHost(host)) {
  console.log(`quotalens: config.json host = ${host}; relay address for the phone: ${relayBase(host)}`);
} else {
  // NOT echoed (M8 QA, same rule as `readExtraHost`): the value is a typo or a pasted URL, and
  // the length is enough to tell which.
  console.error(`quotalens: --host is not a tailnet IPv4 (100.64.0.0/10): got ${host.length} chars; config.json unchanged`);
  process.exit(1);
}
