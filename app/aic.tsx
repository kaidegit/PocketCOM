// Minimal board bring-up UI. Keep the desktop App/session graph out of this entry.
import { ref } from "vue";
import { View, Text } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { t } from "./i18n";
import { theme } from "./theme";

export default function AicApp() {
  const frames = ref(0);
  const touches = ref(0);
  let ticks = 0;
  // Show liveness once per second rather than repainting the counter every tick.
  onFrame(() => {
    if (++ticks % 60 === 0) frames.value = ticks;
  });

  return (
    <View style={{ width: 480, height: 272, bgColor: theme.value.bg }}>
      <Text class="absolute text-xl" style={{ insetL: 20, insetT: 18, textColor: theme.value.fg }}>
        {t("app.title")}
      </Text>
      <Text class="absolute text-sm" style={{ insetL: 20, insetT: 56, textColor: theme.value.dim }}>
        {t("aic.minimal")}
      </Text>
      <Text class="absolute text-sm" style={{ insetL: 20, insetT: 86, textColor: theme.value.dim }}>
        {t("aic.noIO")}
      </Text>
      <Text class="absolute text-base" style={{ insetL: 20, insetT: 130, textColor: theme.value.fg }}>
        {t("aic.frames", { count: frames.value })}
      </Text>
      <View
        class="absolute"
        style={{ insetL: 20, insetT: 184, width: 440, height: 56, bgColor: theme.value.accent }}
        focusable
        onPress={() => { touches.value++; }}
      >
        <Text class="absolute text-base" style={{ insetL: 16, insetT: 16, textColor: theme.value.accentFg }}>
          {t("aic.touch", { count: touches.value })}
        </Text>
      </View>
    </View>
  );
}
