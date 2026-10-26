# AIC 帧边界内存压力回收（2026-10-25）

本文保留本轮 GC 独立改动的历史数据。当时仍失败的 7 MiB 键盘/抽屉/设置组合，已在
[2026-10-26 后续修复](aic-combined-oom-2026-10-26.md)中通过首次及三组 50 轮离板复测；
当前固件为 `dist/aic/combined-oom-fix/`，真机验收仍待补。

## 改动与边界

旧宿主只在无 damage 的帧、间隔满 2 秒后显式 GC。持续重绘会推迟这条路径；QuickJS 的
自适应阈值只看 JS 分配，不包含 Rust UI、包装头和系统堆碎片，不能保证统一 TLSF 先于 OOM 回收。
本次调整 AIC 宿主回收时机，不改变共享 App、JSON profile、5 MiB JS 配额、7 MiB 系统堆或 allocator。

策略在 PocketJS `hosts/aic/port/pocketjs_gc.h`，固件和探针使用同一份判断函数：

- 挂载结束、首帧前先 GC，之后才启动帧时钟，避免启动回收时间成为追赶帧负债。
- 完整帧结束后，guest+Rust 的 caps 占用比上次 GC 后增长 128 KiB 时回收。
- 系统 `total-used` 余量不超过 1 MiB 时，增长门槛降为 32 KiB；即使持续重绘也最多等 2 秒。
- 保留 2 秒空闲 GC。每次 GC 后重新取 caps 基线；不可回收的常驻内存不会造成逐帧 GC。
- 判断只读 O(1) 计数，不逐帧遍历 TLSF，不在 allocator/JS 回调中重入 GC。

`total-used` 是压力信号，不能当作最大可分配连续块。仍可能因碎片、单次大分配或常驻集合过大失败。
新日志阶段 `S5-gc` 记录启动回收后状态；每秒统计增加累计 `gc` 与启动以来的 `gc_max=… ms`。
`turn_max` 沿用 guest turn 耗时，GC 耗时另列，避免把卡顿漏掉。

## 可复现的离板验证

```sh
npm run package:aic
npm run probe:aic -- --aic-gc
python3 tools/aic-memory-stress.py --gc compare --tag normal-7m
python3 tools/aic-memory-stress.py --busy --gc compare --tag busy-7m
python3 tools/aic-memory-stress.py --busy --rapid --gc compare --tag busy-rapid-7m
python3 tools/aic-memory-stress.py --scenario combined --heap 9m --gc compare --tag combined-9m
python3 tools/aic-memory-stress.py --scenario combined --heap 7m --gc compare --tag combined-7m
```

最后一条在本轮历史包上仍失败，保留为容量不足的诊断记录；当前包结果见上方后续修复。
产物在 `.pocket/aic/memory-stress/<tag>/`，含源代码、完整 argv、原始日志和 `report.json`。
`--gc compare` 分别运行旧版空闲策略与新策略；只有候选失败会使比较命令非零退出。
也可指定 `--gc none` 保留无额外回收对照。`probe:aic` 默认仍无额外回收，手动 `--collect`
与两种 AIC 策略互斥。

测试加载同一实际包、QuickJS 和 native core，注入最小无 IO 串口命名空间，让收发区真实挂载。
每组 400 次触摸（200 轮），逐次核对展开状态/输入区 bounds 命中，发送折叠还核对按钮节点复用；
不能只以 frames 或触摸命令发送成功验收。诊断 hooks 与状态查询开销在前后两组相同。

`--busy` 仅将调度器的 idle 输入固定为 false，模拟连续 damage 造成的空闲 GC 饥饿；
**不代表真实 IO、绘制或 WiFi 压力**。虚拟时间按契约 60 Hz 前进，LP64 固定 TLSF 7 MiB，
仍不包含 RV32 指针布局、系统线程、WiFi、framebuffer target 和实际 GC 停顿。

### 48,000 帧 / 无空闲机会

相邻操作间隔 115 帧，跨过输入记录环的 36,000 帧回卷；无手动 `--collect`。
最终记录：`.pocket/aic/memory-stress/busy-final-7m/report.json`。

| 场景 | 旧策略 | 新策略 sys 峰值 / 结束占用 | 新策略 GC 次数 |
|---|---|---|---:|
| 发送折叠 | 第 245 次状态检查后失败 | 6,274,048 / 6,026,528 B | 15 |
| 先用键盘、再发送折叠 | 第 131 次后失败 | 6,517,992 / 6,430,704 B | 188 |
| 键盘开关 | 第 144 次后失败 | 6,540,984 / 6,475,096 B | 203 |

新策略三组均 48,000 正常帧、400 次状态检查通过，`caps_fails=0`，峰值最高约 6.24 MiB。
旧策略三组均记录底层分配失败，并在完成全部计划前退出；异常后的峰值不当作完成同一负载的对照。

### 快速触摸与正常空闲

快速组每 4 帧操作一次，400 次操作后继续到 3,600 帧，仍令 idle=false：

- 旧策略仅发送折叠通过；键盘后发送折叠在第 237 次状态检查后失败，键盘开关在第 278 次后失败。
- 新策略三组均完成 400 次状态检查，零错误/零分配失败，sys 峰值均 6,274,048 B，GC 10/11/10 次。
- 保留真实 raster revision 空闲判断时，旧/新两组普通长测和快速组均通过；不能宣称旧版所有交互都失败。

对应报告在 `busy-rapid-final-7m/`、`idle-normal-7m/`；额外普通快速对照日志为
`.pocket/aic/oom-gc/policy-rapid-summary.log` 与 `idle-rapid-summary.log`。

### 仍失败的边界

键盘使用后打开连接抽屉、再打开设置并编辑，LP64 7 MiB 旧/新策略均失败。
相同组合在固定 9 MiB 下，两者均完成 240 帧、17 个状态检查：旧策略峰值 8,705,536 B，
新策略峰值 8,512,288 B（降低 193,248 B）。9 MiB 是离板诊断池，未改变板端配置。
**压力 GC 不能消除该组合的常驻/首次创建缺口**；后续仍需减少同时挂载的控件和业务容量。

原位 realloc 曾作为离板候选评估，未显著改善本负载，已撤回；最终固件保持原 allocator 与 guest 分配器。

## 回归与交付

- `npm run typecheck`；`bun test test/`：346 pass / 0 fail。
- `bun test test/host/rtthread/`：16 pass / 0 fail，包含 ASan/UBSan 的策略和固定池 allocator 测试。
  策略覆盖首次回收、128/32 KiB 边界、忙帧超时、常驻基线滞回、内存下降和 32 位时钟回卷。
- `npm run check`、`npm run build`、AIC 固件构建及静态预算通过；RGB 相位仍为 `AIC_RGB_CLK_CTL=1`。
- XIP 段 2,971,132 B；OS 2,998,272 / 3,145,728 B；CMA 扣 framebuffer 后 243,780 B。

基线：PocketCOM `e1ec96ab`，PocketJS `dcb3be8e` + 本次 host/header 工作区改动，
luban-lite `fa1db289` 无改动。快照 `dist/aic/oom-gc/` 保存固件、报告、构建日志、
host 源文件/header 与 engine patch；应用包本身没有因本次 host 改动而变化。

| 产物 | SHA-256 |
|---|---|
| `pocketcom-aic.pocket` | `c13caea0456dfc50df88a61f79cee053cbb6155eecd26e5a0d21e6260d8d8006` |
| `d12x_os.itb` | `cbfbc96d72a6a103f0f21d904af9e8f93a08e0ac0a1ed15c8ab39756b9f90b8b` |
| `d12x_demo68-nor_v1.0.0.img` | `82d4c50e3cf72467a2988b5b4b6dc6ab2fd95e7b402e2c7b3a785a6fbff61521` |
| `memory-report.json` | `3adeaee83801c0b452e55b9511dedaec8521e2a9c1b549c93d38d2965a58b163` |

尚未烧录验收。用户复验冷启动 `S5-gc`/frame120、首次键盘、连续输入/开关、抽屉与设置组合，
记录 `gc_max`、系统峰值/稳态、`pjs_mem` 最大连续块和分配失败数；再补 UART 流量、WiFi 状态矩阵。
GC 次数变多的触摸停顿成本也须实测，不能把 LP64 成功写成 RV32/TLSF 真机已解决 OOM。
