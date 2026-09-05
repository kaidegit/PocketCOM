# host/rtthread — RT-Thread 宿主（预留）

远期目标：把 PocketCOM 移植到 RT-Thread。本目录按 RT-Thread package 规范组织，当前仅为占位。

## 规划

- `SConscript` / `Kconfig`：作为 RT-Thread 离线软件包接入固件工程，经 `scons` 编译。
- 原生侧：适配 `bridge/` 的 `com.*` 契约 —— UART（`rt_device_t` 串口框架）、TCP/UDP/WS（lwIP socket）。
- JS 侧：QuickJS guest + PocketJS 嵌入式核心（参考 `vendor/pocketjs/hosts/esp-idf/` 的组织方式）。
- 前期验证：QEMU（如 `qemu-vexpress-a9` BSP）。

详见 SPEC.md §4.3 与 §8 M5。移植评估报告将放入 `docs/`。
