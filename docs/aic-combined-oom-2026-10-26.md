# AIC 键盘、抽屉与设置组合 OOM 修复（2026-10-26）

## 结果与范围

上一轮压力 GC 仍无法完成的“使用发送框软键盘 → 打开连接配置 → 打开应用配置并编辑”组合，
在相同 LP64、7 MiB 固定 TLSF 池、同源帧末 GC 策略下已通过。旧包复现底层分配失败，
新包完成首次组合及 50 轮反复操作，`caps_fails=0`。共享 UI、JSON profile、业务容量、
5 MiB JS 配额和 7 MiB 系统堆均未调整。

这次验证针对离板组合交互边界。尚未烧录本轮固件，不代表 RV32 真机、UART 流量、WiFi 或
实际 GC 停顿已验收。上一轮独立结果保留在 [压力 GC 记录](aic-gc-pressure-2026-10-25.md)。

## 实现

- PocketJS 的 Vue Vapor 编译器识别真实导入绑定的 `View`/`Text`，将安全的普通 JSX 降为
  编译器内部原生节点入口。节点及属性响应更新归所属 Vapor 作用域，多个装饰节点共用一个
  effect，省去逐节点组件实例、attrs 代理、omit Set 和重复属性缓存。复用 native-tree 的
  `domAttrs`，事件包装保持稳定。
- 同名局部变量、展开属性、组件 ref、动态或命名 slot bag 保留普通组件路径；Solid 路径不变。
  原生节点创建、子节点挂载、字体/样式归一化、bounds 命中和作用域清理仍走现有接口。
- 应用配置弹窗首次打开才创建，关闭后移出视口复用。每次打开重新快照当前配置，取消的文本
  草稿不会带入下一次；关闭立即清焦点/软键盘/下拉，隐藏时选区命中区失效，整个 App 卸载时
  释放字段句柄。首次使用后保留控件是有意的常驻换峰值，不能将启动占用当作使用后占用。

## 实际包固定池复测

工具 `tools/aic-memory-stress.py` 加载实际 AIC 包、同源 QuickJS/native core/TLSF，注入无 IO
串口命名空间以挂载真实收发界面。每次触摸后核对状态、不同控件的 bounds 命中及缓存节点身份；
还核对 `q`/`zq` 草稿、设置域输入、取消后重新打开恢复配置。额外诊断开销前后相同。

```sh
npm run package:aic
python3 tools/aic-memory-stress.py --scenario combined --gc policy --tag combined-after-final
python3 tools/aic-memory-stress.py --scenario combined --combined-cycles 50 --gc policy --tag combined-repeat-normal-final
python3 tools/aic-memory-stress.py --scenario combined --combined-cycles 50 --busy --gc policy --tag combined-repeat-busy
python3 tools/aic-memory-stress.py --scenario combined --combined-cycles 50 --busy --rapid --gc policy --tag combined-repeat-rapid
python3 tools/aic-memory-stress.py --busy --gc policy --tag busy-after-combined-fix
```

默认池为 7 MiB；没有手动 `--collect`。`--combined-cycles` 为 0–50，默认只运行首次组合，
50 轮时隔轮退格或保留已修改草稿后取消，以检查重新打开的快照。普通长测跨过 36,000 帧输入
记录环回卷。帧时钟是契约 60 Hz 的虚拟时间，帧数不代表实际运行耗时。

| 包与负载 | 帧数 | 状态检查 | sys 峰值 B | caps 峰值 B | 分配失败 | GC 次数 |
|---|---:|---:|---:|---:|---:|---:|
| 旧包，同策略，首次组合 | 失败于 frame141 | 14/20 | 6,851,352 | 6,702,667 | 10 | — |
| 新包，首次组合 | 240 | 20/20 | 6,552,704 | 6,401,723 | 0 | 7 |
| 新包，正常空闲判断，50 轮 | 48,000 | 420/420 | 6,708,424 | 6,555,939 | 0 | 455 |
| 新包，无空闲机会，50 轮 | 48,000 | 420/420 | 6,708,016 | 6,555,939 | 0 | 454 |
| 新包，无空闲机会，快速 50 轮 | 3,600 | 420/420 | 6,637,200 | 6,485,091 | 0 | 106 |

旧包用 `--package .pocket/aic/combined-fix/before.pocket --tag combined-before-final` 复现，
在首次打开抽屉时失败；其异常后峰值不能视为完成全部负载的峰值。
正常 50 轮结束系统占用 6,503,248 B，TLSF 空闲 479,040 B、最大连续块 268,048 B；
无空闲组分别为 6,502,880 / 479,264 / 269,440 B。这些是结束快照，不是全程最小空闲块。

`--busy` 只将调度器 idle 输入固定为 false，检验无空闲回收机会；不制造真实 IO、绘制或
WiFi 负载。离板池不含板上系统线程/驱动分配，LP64 指针与块布局也不同于 RV32。

既有三组无空闲回归各完成 48,000 帧、400 次状态检查，零分配失败：发送折叠 sys 峰值
5,550,240 B；先用键盘再折叠 5,897,600 B；键盘开关 5,883,048 B。

原始 argv、harness 源码、stdout/stderr 和报告在 `.pocket/aic/memory-stress/<tag>/`；
上述通过报告副本保存于 `dist/aic/combined-oom-fix/`。所有通过报告的 package SHA-256 均与
交付包一致。旧包 SHA-256 为 `c13caea0456dfc50df88a61f79cee053cbb6155eecd26e5a0d21e6260d8d8006`。

## 行为、像素与构建

- `npm run typecheck`、`bun test test/`：346 pass / 0 fail，2,358 个断言。
  真实 Vapor/core 测试覆盖设置字段复用、取消后草稿重置、外部配置更新、隐藏命中隔离及 App 重挂载。
- PocketJS 六个定向测试文件：14 pass / 0 fail，77 个断言；覆盖导入绑定/别名、保守回退、
  文本/几何/禁用点击、条件卸载、Portal、帧更新和旧作用域停止写原生节点。
- 同一实际包字体/atlas 经原生 RGB565 前后回放：软键盘、抽屉、设置、设置键盘、返回主页
  五张画面均 0 像素差异。为使旧包完整绘制，像素对照单独使用相同 16 MiB 诊断池；
  内存验收仍是上面的固定 7 MiB 测试。原始捕获在 `.pocket/aic/combined-fix/`。
- `npm run check`、`npm run build` 和 `npm run build:aic` 通过；桌面功能 profile 不变。
  RGB pixel clock 相位仍为 `AIC_RGB_CLK_CTL=1`。
- 最终静态报告：XIP 2,973,244 B；OS 3,000,320 / 3,145,728 B；CMA 扣双 framebuffer 后
  243,764 B；SW 扣 guest 配额及静态系统预留后 1,441,792 B。静态余量不证明运行时稳定。

## 交付与真机验收

产物目录：`dist/aic/combined-oom-fix/`。基线为 PocketCOM `e1ec96ab`、PocketJS `dcb3be8e`
加本轮及上一轮未提交工作区改动；luban-lite `fa1db289` 未改动。`pocketjs.patch` 包含新增的
编译器/runtime 测试和 GC header，保留这些未跟踪文件才能完整复现。构建日志及内存报告随固件保存。

| 产物 | SHA-256 |
|---|---|
| `pocketcom-aic.pocket`（828,184 B） | `520c8cfbe406e0d73342efbb8f991011c3606f7efb7a59c417de590459685d99` |
| `d12x_os.itb`（3,000,320 B） | `65d3eb686c20977c034e7707564f20781b0561689ad76c82ec21d94a81b335a6` |
| `d12x_demo68-nor_v1.0.0.img` | `13d3ede1a393fb00ef0301585dfd3c21e8d0e236b21300ed1039ef20f9c92ed2` |
| `memory-report.json` | `1f1ed106525599a86560c608efaae39c418f28e6bdec89f9f46b7c4a292699bc` |

IMG 是 SDK 烧录容器，不能按裸镜像写入 OS 分区；烧录流程遵循 `aic-build` skill。
用户负责烧录回传日志，复验冷启动 `S5-gc`/frame120、上述组合反复开关、输入及取消草稿，
采系统峰值/稳态、`caps_fails`、`pjs_mem` 最大连续块、`gc_max` 和交互停顿；之后再验收 UART
流量与 WiFi 状态矩阵。本轮没有扩大系统堆来换取离板通过。
