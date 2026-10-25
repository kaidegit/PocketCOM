# 离板探针固定池 TLSF（2026-10-25）

按用户要求将原 malloc + 总量上限注入改为固定连续内存区，直接编译板端
`vendor/luban-lite/bsp/artinchip/drv_bare/tlsf_heap/tlsf.c`。

- 默认池大小 7,340,032 bytes，`--heap N` 指定池总大小，包含 TLSF 控制区和块元数据；无扩池/malloc 回退。
- 保留板端 heap_caps 三槽包装头和 realloc 先分配后释放语义；包文件缓冲模拟 XIP 留在池外。
- 新增 `sys/sys_max`、`walk_free/walk_maxfree/walk_frags`，失败环固定保存最近 8 条失败瞬间请求、总空闲及最大连续块。
- C/Rust guest 共用该池；系统线程/WiFi、渲染 target、XIP 时延未模拟。LP64 指针及 TLSF 块分布不同于 RV32，相同预算成败仍不能替代真机验收。
- 功能 A/B 两组显式用相同 16 MiB 池，报告记录 allocator、arenaBytes、TLSF 源码 hash 和 SDK revision，并保存新增 C/H 实现快照。

```sh
npm run package:aic
npm run probe:aic -- --heap 7340032
bun test test/host/rtthread/probe-heap.test.ts
```

验证：ASan/UBSan 覆盖固定池耗尽无回退、总空闲足够但碎片拒绝、相邻块合并、对齐/清零/溢出及 realloc
失败保留原内容。默认 7 MiB 空闲探针完成 120 帧、零失败；4 MiB 探针失败并输出内存快照/失败环。
零/负数/溢出/多余后缀和过小池拒绝。terminal on/off 各 3 次固定 16 MiB 测量通过。

原 malloc 探针的比例偏差和无碎片峰值不能直接换算为新池的碎片断点。
UI 折叠 OOM 修复与完整交互压力测试作为后续独立工作，不包含在本测试改进提交中。
