import { BlockList, isIP } from 'node:net';
import { AppError } from '@dbx/shared';

export interface SafeUrlOptions {
  /** Exact host names allowed (case-insensitive). */
  allowHosts: string[];
  /** DNS lookup returning every address of the host. */
  resolve: (host: string) => Promise<string[]>;
}

const blocked = new BlockList();
// IPv4
blocked.addSubnet('0.0.0.0', 8, 'ipv4'); // "this" network, unspecified
blocked.addSubnet('10.0.0.0', 8, 'ipv4');
blocked.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT
blocked.addSubnet('127.0.0.0', 8, 'ipv4');
blocked.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local, cloud metadata
blocked.addSubnet('172.16.0.0', 12, 'ipv4');
blocked.addSubnet('192.0.0.0', 24, 'ipv4');
blocked.addSubnet('192.168.0.0', 16, 'ipv4');
blocked.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking
blocked.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
blocked.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved, broadcast
// IPv6
blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6'); // ULA
blocked.addSubnet('fe80::', 10, 'ipv6'); // link-local
blocked.addSubnet('ff00::', 8, 'ipv6'); // multicast
blocked.addSubnet('64:ff9b::', 96, 'ipv6'); // NAT64 can reach private IPv4 ranges

const V4_MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

/** True when the address must never be contacted (private, loopback, link-local, …). */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    const mapped = V4_MAPPED.exec(address);
    if (mapped) return blocked.check(mapped[1]!, 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true;
}

/**
 * Checks the shape of a gateway base URL without DNS: https only, no credentials, default port and
 * an allowlisted host (exact, case-insensitive).
 */
export function assertGatewayUrlShape(url: string, allowHosts: string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalid('The gateway URL is not valid');
  }
  if (parsed.protocol !== 'https:') throw invalid('The gateway URL must use https');
  if (parsed.username || parsed.password)
    throw invalid('The gateway URL must not contain credentials');
  // URL drops the default port, so any explicit port left here is not 443.
  if (parsed.port !== '') throw invalid('The gateway URL must use port 443');
  const host = parsed.hostname.toLowerCase();
  if (!allowHosts.some((h) => h.toLowerCase() === host))
    throw invalid('The gateway host is not in the allowed list');
  return parsed;
}

/**
 * Validates a gateway base URL before any request: the shape checks above, and no resolved
 * address in a private or local range.
 */
export async function assertSafeGatewayUrl(url: string, opts: SafeUrlOptions): Promise<URL> {
  const parsed = assertGatewayUrlShape(url, opts.allowHosts);
  const host = parsed.hostname.toLowerCase();
  const literal = host.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(literal) ? [literal] : await opts.resolve(host);
  } catch {
    throw invalid('The gateway host could not be resolved');
  }
  if (addresses.length === 0) throw invalid('The gateway host could not be resolved');
  if (addresses.some(isBlockedAddress))
    throw invalid('The gateway host resolves to a private or local address');
  return parsed;
}

function invalid(message: string) {
  return new AppError('VALIDATION_ERROR', message);
}
