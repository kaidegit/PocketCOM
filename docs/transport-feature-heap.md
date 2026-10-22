# transport.* 编译期裁剪与内存对比

测量日期：2026-10-22（Asia/Shanghai）。

五个传输 feature 已接入编译期裁剪，平台实际启停值只以根目录 `pocket.features.json` 为准。`desktop` 代表本项目 macOS 宿主应用配置；AIC 仍使用诊断入口，配置中允许串口不表示板端 UART 桥已实现。

## 裁剪边界

- `app/transports.ts` 在编译时选择传输装配模块；`bridge/transport-serial.ts`、`tcp-client.ts`、`tcp-server.ts`、`udp.ts`、`websocket.ts` 分别有独立模块所有权。网络宿主按单个 op 检测，不再要求四个网络 op 同时存在，也不依赖串口 op。
- 移除禁用协议的选项、参数面板/布局、参数 ref、配置恢复与快照路径、服务端客户端列表 watcher、定向发送控件与专属文案。跨协议共用的文案保留。配置 schema 和历史配置保留，导入/导出不丢失被禁用协议的设置。
- `ComSession` 保持纯 TS，接收装配层传入的允许协议列表；拒绝禁用协议时不调用宿主、不改变连接状态。MCP 的 `force:true` 在断开已有连接之前检查协议，避免失败请求破坏当前连接。loopback 保留作测试连接。
- 共享会话的合流/事件路由/重连机制、兼容 bridge API 及 macOS 原生协议代码保留。此轮裁剪针对 guest 功能装配，不测原生 socket、驱动、流量缓冲或固件静态段的变化。

## 可复现实验

```sh
npm run probe:features -- --feature transport
```

`transport-all` / `transport-serial` 只改变四种网络传输开关；terminal/MCP 等其它值相同。两组使用同一共享 App、AIC plan、480×272、字体和容量，JS 配额 5 MiB，caps 不注入上限。每组独立进程运行三次、每次 120 turns，取各阶段中位数。

默认串口参数面板可见，无 `com.*` 桥；右侧为桥不可用空态，不挂载收发区或终端网格，没有连接、接收历史或发送负载增长。构建核对五个传输装配模块的 feature receipt；QuickJS 入口断言禁用协议不创建参数 ref、选择器不能切入该协议。六次探针均完成，分配失败和错误帧为零。

## 测量结果

以下单位为 bytes，`caps` 包括 QuickJS + Rust UI + 包装头。

| 指标 | 五种传输全开 | 仅串口 | 减少 | 降幅 |
|---|---:|---:|---:|---:|
| S2 资源常驻 | 774,121 | 744,349 | 29,772 | 3.85% |
| S3 编译峰值 | 5,073,740 | 4,865,868 | 207,872 | 4.10% |
| S4 挂载常驻 | 7,069,412 | 6,861,644 | 207,768 | 2.94% |
| S5 稳态 caps | 7,212,835 | 7,005,003 | 207,832 | 2.88% |
| 全过程 caps 峰值 | 7,984,475 | 7,761,100 | 223,375 | 2.80% |
| S5 QuickJS malloc_size | 3,860,618 | 3,740,430 | 120,188 | 3.11% |
| 压缩 JS | 286,445 | 278,275 | 8,170 | 2.85% |
| PAK | 583,232 | 553,712 | 29,520 | 5.06% |

仅串口使稳态减少 **203.0 KiB**，全过程峰值减少 **218.1 KiB**。峰值仍约 7.40 MiB；这一步不足以恢复板端完整 App 挂载，正式入口保持诊断页。

探针使用 64 位 malloc，不模拟 TLSF 碎片，也不包括 RT-Thread 任务栈、WiFi/lwIP 等系统开销；绝对值偏大，差值用于离板评估。是否满足板上预算仍须 WiFi 状态下的真机峰值/稳态验收。

## 产物与验证

完整报告：`dist/transport-feature-heap/report.json`。各 profile 子目录保留 `.pocket`、feature receipt、构建日志和三份探针日志；报告记录原始读数、配置/包 hash、仓库与 PocketJS revision、工作区 patch 和源码快照。

- `npm run typecheck`：通过。
- `bun test test/`：302 项通过，包含单协议/全开/全关、UI/字典特化、参数分配、协议桥隔离、配置保留和 MCP force 拒绝路径。
- `npm run build`：桌面完整构建通过，feature receipt 排除模块数为 0。
- 原生桌面宿主启动冒烟：READY，30 ticks 正常退出。
- AIC 诊断打包及两组真实 QuickJS 探针：通过；未构建/烧录固件。

配置 SHA-256：`476e9c1d39c12f626c1766fdff4576128ba10a84b60a21fb590ceab5be65de64`。
