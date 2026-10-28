# TS 创建阶段诊断（2026-10-26）

上一轮真机配置首开JS阶段1860ms、键盘684ms，详见
[低内存性能记录](aic-perf-low-memory-2026-10-26.md)。用户要求继续定位，并明确临时perf
不必受新增内存限制、后期可以删除，提出直接在TS打日志。本轮交付诊断，不声称首开加速。

## 实现与日志

- AIC诊断宿主在bundle执行前提供 `__pocketjsPerfNowUs()`，直接读取SDK
  `aic_get_time_us()` 完整单调微秒值，以JS Number返回。不用RTC/Date.now，也不用虚拟帧钟。
  沿用 `POCKETJS_DIAG=0` 关闭；未改堆、JS配额、framebuffer、GE暂存或产品feature值。
- `app/main.aic.tsx` 调用 `app/perf.ts` 安装收集器，测挂载、每次frame和原始 `ui.*`
  HostOps。方法包装保留receiver、参数、返回值和异常，不改变事件投递边界。
  普通桌面入口不安装收集器，无诊断时钟时AIC入口也不包装宿主或frame。
- TS组件加入begin/end + try/finally：LeftPanel、SerialBlocks、FieldLabel、Btn、CheckRow、
  SegCtrl、Select、TextField、Scrollbar、SoftKeyboard、KeyboardEditor、KeyboardKeys；
  键盘geometry/label两个watchEffect分开计时。作用域、返回值与清理钩子保留。
- 框架TS细分 `primitive.create/component/watch/props`、`tree.createElement/createTextNode/`
  `insertNode/setProp/setStyleObject/setClass` 和 `vapor.flush`；因此可进一步分辨属性读取、
  样式转换、Vue调度和宿主调用，而不是仅从组件首尾推测。

输出例：

```text
[PJS-TS] batch=frame-11 unit=us (nested totals)
[PJS-TS] create.LeftPanel n=1 sum=... self=... max=...
[PJS-TS] primitive.props n=98 sum=... self=... max=...
[PJS-TS] ui.setProp n=254 sum=... self=... max=...
```

`n`为该batch调用次数，`sum/max`为包含嵌套采样子调用的累计/单次最大时间，`self`
扣除直接子span覆盖的时间；同名递归调用仍会在sum中重复覆盖，**不能相加所有sum**。
self只代表未被其他span包围的观测时间，包含未进一步埋点的工作和诊断开销。
不含console打印，但C层PJS-PERF/turn_max包含这些TS日志的打印时间，故本版整体耗时
不能直接与上一版比较。计时器、包装函数、span对象本身有成本，此版用于找热点。

计时停止后才打印：挂载强制打印；发生组件创建或已采样阶段超过50ms的batch打印，
其余清计数，避免逐次HostOp/正常空闲帧刷屏。Map行按标签复用，临时span仍有分配。
帧后guest jobs产生的样本在下一frame开始前单独flush，避免计入下一frame的inclusive时间；
未包围的jobs总时长仍应参考C层JS阶段，不能由这些子span补算。

## 验证与交付

- TS计时回归验证嵌套self归属、活动span期间不打印、清零复用、慢帧筛选和无时钟不包装宿主。
- 当前源码351项测试/2410断言通过；包含真实Vue Vapor/core的触摸、键盘、面板与接收滚动。
  fork相关13项/128断言通过；typecheck、桌面check/build、实际SDK固件构建通过。
- 实际AIC包由LP64 QuickJS/native core在固定7MiB TLSF中启用本轮诊断时钟运行100turn，
  验证挂载、首次配置及首次键盘日志输出，无运行错误；配置创建7个Select，键盘45个键。
  这是短时诊断冒烟，未模拟XIP、PSRAM、UART/WiFi或真实串口日志开销，不能当成真机结论。
  离板原始日志 `native-trace.log` 随固件保留；不将其毫秒值换算成板上耗时。
- ITB 3008512/3145728 B；包832088 B。静态CMA扣framebuffer后243676 B；
  诊断JS分配与峰值仍待真机采样。内存与速度优化以删除埋点后的同条件复测为准。

产物 `dist/aic/ts-create-perf/`，内含固件、ELF/map、包、memory-report、测试/构建日志和两仓patch。

- ITB SHA-256：`7cec0a6ad84bdfbbc8ba2a26245428232381947dcd667491c60340c22ccce17a`
- 包 SHA-256：`e5625bc095bdf772d39a764f1e30355197ae505c6c6558101bbd13f2bcecd9a4`

真机按“配置打开→收起→发送框聚焦/再点开键盘→输入→收起键盘→收起发送区”，
再展开一次配置和键盘，保留完整PJS-TS/PJS-PERF/内存日志，区分首次与复用。
本轮未烧录，尚无真机细分数据，不能先认定Vue、HostOps或某个控件为最终瓶颈。

## 删除边界

这组临时诊断集中于 `app/perf.ts`、各组件的perfBegin/perfEnd、main.aic安装，
框架 `perf-trace.ts` 及对应beginTsPerf/endTsPerf、vue-vapor-flush包装，
AIC `pocketjs_diag_install`/宿主调用和时钟安装函数。去掉这些即可撤销TS诊断；
原有PJS-PERF及上一轮DOM按需、GE清padding、无damage不PAN的优化独立保留。

## 2026-10-27 真机回传

原始日志保留 `dist/aic/ts-create-perf/user-board-trace.log`，从frame120附近开始，无挂载TS段。
frame120系统4472308 B、对象4926、caps_fails=0；本段交互系统历史峰值5703680 B，
未见分配失败日志。TS诊断相对前轮frame120多38816 B；操作/输入不同，不作严格峰值A/B。

| 观测 | 配置首次展开（frame197） | 键盘首次展开（frame399） |
|---|---:|---:|
| TS frame inclusive us | 3054866 | 1611462 |
| Vue flush inclusive us | 3016910 | 1543942 |
| create.LeftPanel / KeyboardKeys geometry effect inclusive us | 2108847 | 1088816 |
| primitive.props inclusive us | 1092634 | 163215 |
| tree.setStyleObject inclusive / self us | 412513 / 311902 | 589784 / 435072 |
| ui.setProp 调用数 / 累计 us | 254 / 100611 | 414 / 154712 |
| C raster 最大 us | 64818 | 74876 |

配置创建138个native节点、7个Select；键盘创建59个native节点，其中45个为固定键。
primitive.create递归累计16915605us，远超整帧3.05秒，不能拿该sum当首开时间。
其self=1094774us也包含子span结束后统计Map的开销，不能全部归因于未埋点的业务工作。
本版插桩后JS停顿大于前版，不能按耗时差认定业务退化。

这些样本支持优先减少通用节点/属性处理和密集JS/C往返，而非单独重写Select业务。
键盘geometry effect占用较大，样式路径有57次调用、414次native属性写入。
后续选择补齐既有setPropBatch并让inline style合批，见
[样式批量提交](aic-style-batch-2026-10-27.md)。

本日志未出现足以明确量化配置/键盘第二次展开的完整操作样本；不能报告复用速度。
显式GC最大68ms，不足以解释本次秒级TS创建阶段；JS内自动GC仍未独立分离。
