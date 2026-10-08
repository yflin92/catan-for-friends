// Preloaded by gamenight-preflight.fake-docker.mjs in place of a container's /etc/hosts entries from --add-host: the
// names in FAKE_ADD_HOSTS resolve to 127.0.0.1 (where the test's fake site listens); other names resolve as usual.
import dns from 'node:dns';

const names = new Set((process.env.FAKE_ADD_HOSTS ?? '').split(',').filter(Boolean));
const lookup = dns.lookup;
dns.lookup = function (host, options, callback) {
  if (typeof options === 'function') return dns.lookup(host, {}, options);
  if (!names.has(host)) return lookup.call(this, host, options, callback);
  const all = typeof options === 'object' && options !== null && options.all;
  if (all) process.nextTick(callback, null, [{ address: '127.0.0.1', family: 4 }]);
  else process.nextTick(callback, null, '127.0.0.1', 4);
};
