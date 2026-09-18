import { SvgXml } from "react-native-svg";

import { ACP_PROVIDER_ICON_SVGS } from "@/assets/acp-provider-icons";
import type { ProviderIconProps } from "@/components/provider-icons";

export function MiniMaxIcon({ size }: ProviderIconProps) {
  return <SvgXml xml={ACP_PROVIDER_ICON_SVGS.minimax} width={size} height={size} />;
}
