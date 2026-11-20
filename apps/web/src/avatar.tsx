import type { CSSProperties } from "react";
import { ProviderLogo, providerLogoName } from "./provider-logos";

export function avatarHue(name: string): number {
  let hash = 0;
  for (const char of name.toLocaleLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }
  return hash;
}

/** 头像内容：Agent 显示厂商标识（未知厂商回退为 "AI"），人类显示名字首字母 */
export function AvatarGlyph({
  type,
  name,
  provider,
}: {
  type: string;
  name: string;
  provider?: string;
}) {
  if (type !== "agent") return <>{name.slice(0, 1).toUpperCase()}</>;
  const logo = providerLogoName(provider);
  return logo ? <ProviderLogo provider={logo} /> : <>AI</>;
}

export function avatarHueStyle(name: string): CSSProperties {
  return { "--avatar-hue": avatarHue(name) } as CSSProperties;
}
