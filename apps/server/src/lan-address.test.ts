import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { lanAddresses } from "./lan-address.js";

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  };
}

describe("lanAddresses", () => {
  it("puts physical interfaces ahead of VPN tunnels and self-assigned addresses", () => {
    expect(
      lanAddresses({
        lo0: [ipv4("127.0.0.1", true)],
        utun4: [ipv4("192.168.115.246")],
        en7: [ipv4("169.254.10.2")],
        en0: [ipv4("192.168.1.110")],
        bridge100: [ipv4("192.168.64.1")],
      }),
    ).toEqual(["192.168.1.110", "192.168.115.246", "192.168.64.1", "169.254.10.2"]);
  });

  it("reads the current interfaces on every call", () => {
    expect(lanAddresses({ en0: [ipv4("172.20.10.6")] })).toEqual(["172.20.10.6"]);
    expect(lanAddresses({ en0: [ipv4("192.168.1.110")] })).toEqual(["192.168.1.110"]);
  });
});
