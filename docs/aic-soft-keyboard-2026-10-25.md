# AIC 文本域二次点击软键盘（2026-10-25）

本文保留首次交付快照的数据。后续临时编辑面板和按键居中见
[新交付记录](aic-keyboard-editor-2026-10-25.md)，最新固件在 `dist/aic/keyboard-editor-fix/`。

## 行为与修复

原 AIC profile 裁剪了软键盘，共享 TextField 的点击处理也只聚焦。
本次按用户要求启用 ASCII 软键盘，所有文本域统一首次点击聚焦、再次点击当前域展开；
两次为独立点击，无双击时限。已展开时再点保持展开，收起后点当前域重新展开。
程序 `focus()` 不展开；拖动与取消不展开；失焦、切换域、字段卸载收起并忘记旧目标。
状态栏入口保留，大小写、数字、符号、空格、退格和回车沿用活跃文本域协议。

桌面选区在 mouse down 已设置活跃域，因此记录按下前的状态，只在未拖动且原位释放时
提交键盘请求；AIC 使用引擎的 tap-to-press 仲裁，不从触摸 down 或每帧轮询展开。
软键盘新增幂等 `openKeyboard()`；关闭状态拒绝残留按键输入。

为限制创建峰值，键盘首次使用才创建，之后移出视口隐藏复用；大小写只更新固定节点的标签与输入值。
每个键位使用一个有底色的 MiSans Text 节点，经 renderer 的公共属性接口绑定焦点和 press，
避免每键额外的组件/容器；按键区域与原版相同。复用 Portal host 自身设为 zIndex 1001，
高于普通 Portal host，避免后创建的连接抽屉/设置遮住键盘。隐藏时不截获底层 bounds 命中。
功能启停仍只查 `pocket.features.json`，没有改变其他 feature、堆配额或容量。

## 本地验证

- `npm run typecheck`、全仓库 `bun test test/`：336 pass，0 fail（1810 项断言）。
- `npm run check` / `npm run build`、AIC check/package/build 全通过。
- 新增 `test/app/soft-keyboard-touch.test.ts`：真实共享 App、Vue Vapor、原生核心 WASM，
  按 JSON 的 AIC / UI 开 / UI 关三种 profile 运行，149 项断言，无跳过。
  覆盖发送框、自定义波特率和应用配置，首次/再次点击、长按不重复、拖动/CANCEL 不展开、
  桌面选区提前聚焦不误弹、程序聚焦不展开、大小写保持节点身份、输入/退格/回车、
  10 轮开关复用、收起后命中恢复、卸载清焦点，以及后创建抽屉/设置上的键盘层级。
  自定义波特率的 Select 末项在 480×272 下越屏，测试建立状态时直接激活该选项；随后字段和键盘均走真实 bounds 触摸。
- `ui-features.test.ts` 验证禁用软键盘仍移除模块/文案、普通编辑保留；同步验证
  幂等展开、同 tick 失焦再聚焦不重开、切换字段收起以及关闭状态不输入。
- 实际 `.pocket` 原生 RGB565 离板回放已检查 focused/open/typed-closed 三张 480×272 图片，
  键盘正常显示，输入 q 并收起后发送草稿保留。

## 实际包 QuickJS / native core 检查

使用交付 `.pocket` 和同源可移植核心，按原生 AIC 触摸输入运行 240 turns；
离板 runner 注入仅用于测试的 com mock 以挂载发送区，包装 ui 记录节点/文字，逐轮检查实际
bounds 命中是否处于键盘 host 下。诊断代码没有进入交付包。没有额外 GC，也没有提高默认 5 MiB JS 配额。

顺序：发送框第一次点击 → 第二次点击 → 输入 q → 收起 → 再开关六轮 → 打开抽屉/设置 →
设置文本域第一次/第二次点击 → 输入数字 → 收起 → 关闭设置。所有开关状态断言通过，
240 正常帧、0 错误帧、0 caps 分配失败；同一个键盘 host 全程复用。

离板数据，单位 bytes：

| 场景 | caps 存活 | 历史峰值 |
|---|---:|---:|
| 默认探针、无 com 桥，120 turns 空闲对照 | 3,830,458 | 4,836,600 |
| com mock 发送区，首次展开键盘后 turn16 | 6,997,407 | 7,011,726 |
| 多轮收起/展开后 turn132 | 7,041,194 | 7,050,994 |
| 加入抽屉/设置并完成编辑后，turn240 | 9,168,627 | 9,286,021 |

末帧 JS malloc_size 为 4,930,570 / 5,242,880。以上为 64 位指针 + malloc 的离板口径，
含诊断包装，不含 RT-Thread 系统线程、WiFi 和真实串口负载，也不模拟 TLSF 碎片。
组合场景离板 caps 超过板上 7 MiB SW 堆，**不能据此确认板端有足够运行余量**，
也不能按固定比例宣称真机通过。首次展开、组合峰值、长时与实际收发仍须真机采样。

## 交付

快照：`dist/aic/soft-keyboard-fix/`，含 `.pocket`、ITB、IMG、静态内存报告、测试、
`metadata.json` / `SHA256SUMS`，以及 diagnostics 下的原始日志、runner 和 RGB565 回放截图。
SDK 构建产物仍在 `vendor/luban-lite/output/d12x_demo68-nor_rt-thread_pocketjs/images/`。

| 文件 | SHA-256 |
|---|---|
| pocketcom-aic.pocket | `65bdc9054f271e4aa50948e7afa21e4def38b00a06c3b68223a820c2cd261221` |
| d12x_os.itb | `472e82eeb785141f5929104c9f2aab83eb2457cb90f53a30e6f4b437734c5160` |
| d12x_demo68-nor_v1.0.0.img | `0454b0df6e28d932e2cfa2e9b15a77ab33c32925395116eeaa74015fa1c67e4b` |

静态预算：包 820,504 B，XIP 段 2,965,308 B；OS 2,992,128 / 3,145,728 B，
余 153,600 B；扣双 framebuffer 后 CMA 余 243,780 B；SW 扣 guest 配额和静态预留后余
1,441,792 B。此报告只校验静态预算，不包含运行峰值。
PocketJS `dcb3be8eed65fde62d3ca30b56ac1820a00e3ebd`、luban-lite
`fa1db289bacd8b0f8a3821c174d17fc1a2f69d19`，本次未修改子模块源码。

## 真机待验收

用户负责烧录并回传 `[PJS-DIAG]` / `pjs_mem`：启动/120 帧、首次选中/展开、输入并收起、
反复开关与大小写、抽屉内参数编辑、应用配置编辑、输入发送。记录系统/caps 峰值、稳态、
分配失败和帧错误，并确认键盘没有遮挡自身按键、收起后底层可点。

发送框 `(100,200)`，键盘 `0..480 × 80..244`，q `(29,126)`，收起 `(430,226)`。
设置入口 `(130,249)`，当前 AIC profile 设置输入框 `(250,99)`。
键盘覆盖发送框，不调整工作区几何；收起后查看输入内容。以上只通过离板验证，真机状态仍为待验收。
