import { networkInterfaces } from "node:os";

type Interfaces = ReturnType<typeof networkInterfaces>;

/** VPN 隧道、虚拟机/容器网桥：手机扫码一般连不上，排到最后 */
const VIRTUAL_INTERFACE =
  /^(utun|tun|tap|ppp|ipsec|wg|gif|stf|awdl|llw|bridge|vboxnet|vmnet|docker|br-|veth|virbr|zt|tailscale)/i;

function rank(name: string, address: string): number {
  if (VIRTUAL_INTERFACE.test(name)) return 2;
  // 169.254.x.x 是没拿到 DHCP 时的自分配地址，别的设备访问不到
  if (address.startsWith("169.254.")) return 3;
  return 0;
}

/**
 * 本机对外的 IPv4 地址，可能被其他设备访问到的排前面。
 * 每次现取：换 Wi-Fi、开关手机热点、连 VPN 后不用重启 Server。
 */
export function lanAddresses(interfaces: Interfaces = networkInterfaces()): string[] {
  const found: { address: string; rank: number; order: number }[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      found.push({ address: entry.address, rank: rank(name, entry.address), order: found.length });
    }
  }
  return found.sort((a, b) => a.rank - b.rank || a.order - b.order).map((item) => item.address);
}
