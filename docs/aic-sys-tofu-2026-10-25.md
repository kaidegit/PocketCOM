# AIC 接收区系统消息豆腐修复（2026-10-25）

## 现象

板端接收区里系统消息（sys 行）显示为豆腐块：`[系统]` 前缀与中文文案（如
`打开连接失败`、`未选择串口`、`缓冲溢出，已丢弃 N 帧`）全部是替换符方块。
接收到的数据内容含 CJK 时的豆腐按 SPEC 属于允许范围（用户可切 HEX 查看），
本次只修系统消息。

## 根因

接收区日志行的三段（时间戳 / 来源前缀 / 内容）全部用 `MONO_CLASS`
（JetBrains Mono 烘焙槽）渲染；烘焙器每槽单一字体，mono 槽 charset 只含
ASCII + 符号（JetBrains Mono 不映射 CJK，收集到的 i18n 码点直接落选），
sys 前缀/内容是 i18n UI 文案，落 mono 槽在板端必然豆腐。桌面端
CoreText 系统回退掩盖了缺字，因此只在板端可见。

## 修复（SPEC 先行）

- **SPEC §5.4**：sys 行来源前缀 `[系统]`/`[SYS]` 与消息内容改归 MiSans 槽
  （UI 文案），时间戳段与 RX/TX 数据内容保持 mono；"允许豆腐"收窄为仅数据
  内容（RX/TX 数据、终端输出、宿主枚举端口描述等运行时字符串）。TX 来源
  前缀 `[手动发送]`/`[MCP发送]` 保持 mono（仅 MCP server 运行中显示，
  嵌入式目标不装配 mcp.server，无板端豆腐风险）。AGENTS.md 字体条目同步。
- **core/logview.ts**：`LogViewOptions` 新增 `measureUi`；sys 行折行改用 UI
  槽度量与独立宽度缓存（`widthCacheUi`），`remeasure`/`configure(remeasure)`/
  `clear` 同步清两套缓存；未注入 `measureUi` 时 sys 行回退数据行度量。
- **app/fontsize.ts**：新增 `UI_SLOTS`（12/14/16px → 槽 0/1/2，
  与框架 `fontSlotFor` 对齐）。
- **app/widgets.tsx**：`measureUi(text, slot = 0)` 支持按档位取 UI 槽。
- **app/session.ts**：LogView 装配注入
  `measureUi: (s) => getOps().measureText(s, UI_SLOTS[fontSize.value])`。
- **app/transfer.tsx**：sys 行前缀/内容渲染 `TEXT_CLASS`（`rowTextClass`/
  `prefixTextClass`）；时间戳段与数据内容（含颜色分段 contentRuns）保持
  `MONO_CLASS`；`logCellAt`/`logSelRect` 选区几何按行类别分派 mono/UI 槽
  度量（仅桌面 `ui.selection` 生效）。

时间戳段仍按 mono 渲染、但 sys 行整行按 UI 槽度量折行——首行折行点存在
小误差（mono 数字宽 vs MiSans 数字宽），sys 消息短、实际不触发；不影响显示
正确性。

## 验证

- 单测：`test/core/logview.test.ts` 新增 3 项（sys 行用 measureUi 折行且
  数据行不受影响、未注入回退、remeasure 清 UI 缓存后重折行）；
  `bun test test/` 全量 345 项通过，`npm run typecheck` 通过。
- `npm run package:aic` 烘焙日志：UI 槽 0/1/2（12/14/16px MiSans）各
  **246 字形**（含全部 i18n 码点），mono 槽 16/17/18 各 103（ASCII+符号）；
  `dist/aic/pocketcom-aic.pocket`（826,392 bytes）产出。
- 离板烘焙观感：`npm run build:aic-sim` + `node tools/dev.mjs --baked-text
  --resolution 480x272 -- --no-native-mouse-keyboard --click 60,16@60
  --click 136,215@70 --click 450,80@82 --screenshot …@95 --quit-after 105`
  （打开抽屉 → 点“打开”触发 sys 行 → 遮罩关闭）。板端同源烘焙 GLYPH_RUN
  路径下 `[系统] connected: /dev/cu.wchusbserial… @ 115200` 中 **`[系统]`
  为正常汉字非豆腐**，状态栏 `已连接` 正常。

- 固件构建：`RTT_EXEC_PATH=…xpack-riscv-none-elf-gcc-15.2.0-1/bin npm run build:aic`
  通过，静态预算内（XIP 2,971,260 B @0x60100800、OS 分区 2,998,272/3,145,728 B、
  framebuffer 后 CMA 余 243,756 B、guest+reserve 后 SW 余 1,441,792 B）。
  快照 `dist/aic/sys-tofu-fix/`（`pocketcom-aic.pocket`
  sha256 `c13caea0…9d8006`、`d12x_os.itb` sha256 `7a0a7df6…4d9624` +
  memory-report.json）。

## 待验收边界

- 真机烧录复验由用户执行（产物 `dist/aic/pocketcom-aic.pocket`）；
- RX/TX **数据内容**含未烘焙字符仍按 SPEC 显示豆腐（允许，切 HEX 无损）；
- sys 文案中的运行时插值（宿主错误串等任意字符串）若含未烘焙字符仍可能
  豆腐——属 SPEC 允许的运行时字符串范围；
- 板端内存未单独复测：本改动不新增节点/常驻结构，仅折行度量分派与渲染
  class 变化；120 帧基线随真机复验顺带确认即可。
