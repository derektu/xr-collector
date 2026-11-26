import { createServer } from 'node:net';

// External: a listener that asks the OS for any port gets one from the ephemeral range: 49152-65535 on
// Windows (https://learn.microsoft.com/en-us/troubleshoot/windows-server/networking/default-dynamic-port-range-tcpip-chang)
// and on macOS (sysctl net.inet.ip.portrange.first and .last), and 32768-60999 by default on Linux
// (net.ipv4.ip_local_port_range, https://www.kernel.org/doc/html/v6.12/networking/ip-sysctl.html).
const LOWEST = 20_000;
const HIGHEST = 32_767;
const ATTEMPTS = 20;

function canBind(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port }, () => server.close(() => resolve(true)));
  });
}

/**
 * A port free on 127.0.0.1 and below every OS's ephemeral range, so no listener that asks the OS for
 * any port takes it after a test releases it. Throws when no tried port is free.
 */
export async function portBelowEphemeralRange(): Promise<number> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const port = LOWEST + Math.floor(Math.random() * (HIGHEST - LOWEST + 1));
    if (await canBind(port)) return port;
  }
  throw new Error(`no free port in ${LOWEST}-${HIGHEST} after ${ATTEMPTS} attempts`);
}
