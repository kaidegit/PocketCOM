# 粗粒度TS计时与scalar/batch对照（2026-10-27）

## 目的

用户要求继续确认inline style批量提交的净收益。前轮密集TS埋点的真机首开观察改善，
但减少HostOp调用也减少了逐调用计时的开销，因此不能把16%/30%直接视为产品加速比例。
原始数据见 [样式批量提交](aic-style-batch-2026-10-27.md)。

本轮只减少诊断开销并准备同口径对照，不改变产品feature、容量、时钟、缓存、GE路径、
堆/栈或JS配额，不增加预加载/缓冲区。用户仍负责烧录并回传日志。

## 修改与控制变量

- 移除native-tree全部6处函数级trace（节点创建、插入、class、style、setProp），
  移除Vapor原语create/component/watch/props共4处trace及不再需要的导入。
  样式batch与原语同作用域更新逻辑保留。
- app/perf.ts不再包装任何ui.*方法，保留组件、键盘分组effect、Vue flush与frame。
  日志增加 `mode=coarse props=batch/scalar`；清零/慢帧筛选不再每帧分配rows展开数组。
- 仍在span结束后打印；TS frame/组件时间不含之后打印，C层JS总时间仍包含打印。
  粗粒度探针仍有开销，这轮不能代替完全撤除诊断后的最终产品性能验收。

两份固件同源、同JSON profile、同C绑定和粗粒度探针：

| 固件 | 运行路径 | 启动标识 |
|---|---|---|
| dist/aic/coarse-perf-scalar/ | 诊断入口删除可选ui.setPropBatch，走现成scalar兼容路径 | mode=coarse props=scalar |
| dist/aic/coarse-perf/ | 正常保留ui.setPropBatch，inline style合批 | mode=coarse props=batch |

scalar对照只在构建期间临时修改main.aic.tsx；保存其源码/entry.patch后恢复，再构建batch。
源码工作区最终为batch版本。对照不是新增产品启停表，没有修改JSON产品功能值；
只用于验证已有可选HostOp缺失时的兼容路径。两份包/ELF地址和对齐不完全相同，
实际XIP缓存/调度噪声仍需真机同序列、必要时重复采样控制。

## 验证与结果

- 351项当前源码测试/2410断言、14项fork测试/142断言通过；typecheck、桌面check/build、
  实际QuickJS批量接口集成回归和两份SDK固件构建通过。
- 实际包经LP64 QuickJS/native core，固定7MiB TLSF，scalar/batch各三次100turn；
  验证真实ui.setProp引用在应用挂载前后不变，确实没有包裹HostOps。
  两版首次配置均24个采样span、键盘均8个，n计数一致；日志不再出现ui./tree./primitive.段。
- 离板粗粒度frame三次中位数：配置scalar3968us、batch4173us，键盘scalar1200us、
  batch1328us。该平台上batch并未显示速度收益；它的JS/C边界、XIP与PSRAM代价和板端不同，
  原始少量毫秒样本也存在抖动，不能据此推断AIC加速或回退。
- 无TS诊断时钟的正常产品路径：busy/rapid各50轮、各420/420状态检查通过，系统峰值
  6538728/6466232 B，caps_fails=0。busy仅让GC看不到空闲，不模拟UART/WiFi负载。
- 另用实际包、单调时钟开启粗粒度收集器跑busy/rapid各50轮：各420个状态与未启用
  时钟的对应基线完全一致，系统峰值6554408/6483680 B、caps_fails=0；确实采到
  mode=coarse props=batch，未出现密集段。48,000/3,600为虚拟turn，不是真机浸泡时长。
- 与旧密集诊断包比较，scalar/batch的6个480×272 RGB565状态均零像素差异；
  使用实际字体、QuickJS/core/CPU renderer，但没有模拟真实GE/DMA/显示验收。

真机同口径A/B已回传，批量版在本组样本更慢，已撤回自动合批，详见文末。采样跨度、裸产品收益、反复展开与长时/业务负载仍不能由离板结果替代。

## 产物与复测

scalar和batch各自目录包含完整ITB/IMG、ELF/map、包、memory-report与实际入口源码。
共用测试、原生计时/像素/压力摘要与两仓工作区patch在batch目录保存。
构建控制脚本/源差异随产物保留；默认dist/aic当前产物也是batch。

先烧scalar对照，重启后执行“配置打开→收起→发送框聚焦/再点展开键盘→输入→收起键盘→
收起发送区”；再烧batch，重启后执行同样序列。每步停2–3秒，并各再展开一次配置/键盘。
保留启动mode行、PJS-TS、PJS-PERF和内存/GC日志；若有抖动，再按同样条件重复。
主要比较create.LeftPanel、键盘geometry effect和对应TS frame，不能与旧密集版的self直接对比。

| 产物 | scalar | batch |
|---|---:|---:|
| ITB B | 3008512 | 3008512 |
| 包 B | 831704 | 831656 |
| CMA扣framebuffer后 B | 243684 | 243676 |

scalar ITB SHA-256 `4f40c01ae0765eb54bc1d8691037fe5b7838eba5facdbcecb69ff31c13ca9281`；
batch ITB SHA-256 `8de31f90eb8b3969286d958111ef216e996d457a5365c874fc226372c7bc78f4`。
scalar包 SHA-256 `c0af329899fc57aba58888274010afb16c115e371a6f96af42a68edb37b593b9`；
batch包 SHA-256 `0f2881d6e8235ab707eb54ab4007fcdc4fb71a0c2e9bddbfa3b58c8c1da09904`。

## 真机同口径A/B：撤回自动样式合批

原文分别保存在 `dist/aic/coarse-perf-scalar/user-board-trace.log` 和
`dist/aic/coarse-perf/user-board-trace.log`。启动行分别明确为props=scalar与props=batch，
没有把两份固件认反。两者首次配置创建次数相同（7个Select/FieldLabel等），键盘geometry
均执行2次；硬件CPU396/GE147/DE98MHz、D-Cache/SYSMAP读回一致。

| 阶段 us | scalar | batch | batch慢 |
|---|---:|---:|---:|
| mount | 1807076 | 2122075 | 17.43% |
| 配置首开TS frame | 1523915 | 1801512 | 18.22% |
| create.LeftPanel | 1127837 | 1323466 | 17.35% |
| 键盘首开TS frame | 556207 | 670350 | 20.52% |
| 键盘geometry effect | 324354 | 388201 | 19.68% |
| 配置C层JS最大值 | 1584011 | 1862158 | 17.56% |
| 键盘C层JS最大值 | 600009 | 715457 | 19.24% |

TS与C层JS方向一致；配置raster约62ms、键盘约71ms，两版接近。由这组同口径数据，
不能把此前密集埋点版16%/30%的改善当成净收益。减少HostOp的调用数不等于减少总耗时。
代码中新增的number[]收集、Float64Array构造和分配可能抵消了边界节省，但尚未独立量化
其占比；单次A/B、XIP地址/缓存与调度噪声也不足以宣称所有负载均固定慢18%–21%。
当前没有支持默认启用的净收益证据，因此撤回自动路径，而非继续按调用次数验收。

frame120系统：scalar4452936 B，batch4455992 B（+3056 B）；caps_fails均0。
交互系统峰值scalar5685656 B、batch5672512 B；scalar有更多按键等输入，峰值不作严格
内存收益结论。两者显式GC最大67/66ms，交互后没有完整caps失败计数快照。
该日志未明确覆盖配置/键盘第二次打开，不能量化复用时间。

### 恢复版交付

`dist/aic/scalar-style/` 为恢复逐属性inline style的正常入口：不删除或伪造宿主能力，
共享renderer不检查batch接口、不建number[]/Float64Array包，直接编码并即时setProp。
原DOM容器按需、节点/slot优化、GE清padding、无damage不翻页、时钟/缓存诊断保留。
已经独立验证的可选C batch接口仍在，供显式createJumpBatch使用；本产品app/core当前
没有此调用，不参与inline style。保留粗粒度组件/Vue/frame诊断，不再加密集采样。

启动行改为 `mode=coarse inline=scalar batch_api=1`，明确区分inline路径和可选接口存在。
旧props=scalar/batch仅用于上述历史对照，不能再用接口存在来推断当前样式走法。
恢复的是代码路径，并未以本轮本地验证宣称真机1.52秒已再次复验；恢复版真机时间仍待补。

恢复版本地验收：351项源码/2410断言、14项fork/142断言、typecheck、桌面check/build和
实际SDK构建通过。与较快的scalar对照包6状态RGB565零像素差异；实际包开启单调时钟
100turn，验证inline=scalar/batch_api=1、原始setProp引用保持及首次配置/键盘创建，无失败。
固定7MiB普通产品路径busy/rapid各50轮、420/420，系统峰值6535296/6464448 B，caps_fails=0；
这些虚拟turn和LP64指针/allocator不能替代板端验收。测试/原始日志/报告随恢复版保存。

恢复版ITB 3008512/3145728 B，包 831496 B；
CMA扣framebuffer后 243692 B。
ITB SHA-256 `858300e4063ada2684b83c7834bc443f74f301b15dee263fa377bb5dcdf44ad9`；
包 SHA-256 `a347745a92ff20e0353c88f33f1fe8ef3015d5042b18fedb66a85a2982884995`。
