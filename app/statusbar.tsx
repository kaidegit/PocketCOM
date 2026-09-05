// app/statusbar.tsx — 底部状态栏（SPEC §3.1）：连接状态 │ 摘要 │ Rx/Tx 计数 │ MCP 状态。
import { Text, View } from "@pocketjs/framework/components";
import { theme } from "./theme";
import { t } from "./i18n";
import { connState, connSummary, mcpState, rxCount, txCount } from "./session";
import { Hairline, StatusDot } from "./widgets";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function stateColor(): string {
  switch (connState.value) {
    case "CONNECTED":
      return theme.value.stateConnected;
    case "CONNECTING":
      return theme.value.stateConnecting;
    case "LOST":
      return theme.value.stateLost;
    default:
      return theme.value.stateDisconnected;
  }
}

export function StatusBar(props: { height: number }) {
  return (
    <View class="flex-col" style={{ height: props.height, bgColor: theme.value.panelBg }}>
      <Hairline />
      <View class="flex-row items-center gap-3 px-3 flex-1">
        <StatusDot color={stateColor} size={8} />
        <Text class="text-xs" style={{ textColor: stateColor() }}>
          {t(`conn.status.${connState.value.toLowerCase()}`)}
        </Text>
        {connSummary() !== "" ? (
          <Text class="text-xs font-mono" style={{ textColor: theme.value.dim }}>
            {connSummary()}
          </Text>
        ) : null}
        <Text class="text-xs font-mono" style={{ textColor: theme.value.dim }}>
          Rx: {fmtBytes(rxCount.value)}
        </Text>
        <Text class="text-xs font-mono" style={{ textColor: theme.value.dim }}>
          Tx: {fmtBytes(txCount.value)}
        </Text>
        <View class="flex-1" />
        <Text class="text-xs" style={{ textColor: theme.value.dim }}>
          {mcpState.value.on ? `${t("mcp.on")} (${mcpState.value.clients})` : t("mcp.off")}
        </Text>
      </View>
    </View>
  );
}
