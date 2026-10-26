# AIC UART1 接收文字延迟（2026-10-26）

用户在 UART1 TX/RX 上加跳线帽做硬件回环，发送 `aaa` 后 TX/RX 立即各为 3 B，
接收文字要等较久才出现。本轮定位到会话泵使用不可靠的日历时钟驱动静默超时，已改为
框架帧时钟并构建固件；修复后真机延迟尚待用户烧录复验。

## 根因与证据

数据路径是 `com.poll()` → `ComSession.handleEvent()` → base64 解码 → RX 计数增加 →
`FrameCoalescer.feed()` → 后续 `tick()` 静默超时 → RX 消息入总线 → `LogView.sync()` → 接收文字。
计数在成帧之前更新，因此 TX/RX 均为 3 B 只能证明字节已到会话，尚不能证明 RX 已成帧。

旧 `app/app.tsx` 每帧调用 `pumpSession(Date.now())`。115200、8N1 按现有 SPEC 公式的
静默阈值约为 0.191 ms，但 `Date.now()` 在当前固件上不可靠：

- 当前构建生成的 SDK `.config` 明确为 `# CONFIG_RT_USING_RTC is not set`，`rtconfig.h`
  无 `RT_USING_RTC`。RT-Thread `components/libc/compilers/common/ctime.c` 的无 RTC
  路径返回错误，不写传入 `timeval`；`gettimeofday()` 随后设置 `EINVAL`、返回 -1。
- 本轮 `d12x.elf` 中 `gettimeofday`（0x60105aae）反汇编确认该路径：在 timezone 为空时直接
  `rt_set_errno(22)`、返回 -1，没有写入 timeval。证据保存于固件目录的 `gettimeofday.asm`。
- AIC 使用的 QuickJS `cutils.h:js__gettimeofday_us()` 定义了未初始化的 `struct timeval tv`，
  调用 `gettimeofday(&tv, NULL)` 后未检查返回值，直接读 `tv_sec/tv_usec`。
  `quickjs.c:date_now()` 和 `js_Date_now()` 将结果提供给 `Date.now()`。
  失败时读到的值不能用于超时计算，可能不推进或回跳，不能给延迟规定一秒的上限。
- 另查 AIC RTC 驱动 `drv/rtc/drv_rtc.c`，其 `rt_rtc_ops` 只实现秒级读取，`get_timeval`
  为 NULL；即便以后单独启用该 RTC，原毫秒级静默计时仍会受到整秒精度限制。

最初仅据 RTC 驱动判断为“等待换秒”，随后核对产品配置和 ELF 后更正为上述
“当前无 RTC、系统调用失败”的根因。未修改 SDK、QuickJS 或 RTC 配置。

## 修复

`app/app.tsx` 改为 `pumpSession(virtualNow() * 1000)`，AIC 和桌面共用同一条帧驱动路径。
纯 TS 的帧合流公式、字节事件协议、source、计数和消息总线均保持原实现。
自动重连期限同样使用该时间域，与已有框架定时发送保持一致。

消息总线的日历时间戳来源保持原实现；本轮不提供 AIC 的有效日历时间或 RTC 校时功能。
常用波特率下，孤立短包在下一次超过静默阈值的帧泵产出，无需追加换行；
60Hz 对应约一帧虚拟时间，不能推导为真机显示耗时必定小于 16.7 ms。

## 验证

- 新增 `test/app/serial-receive-clock.test.ts`，编译真实共享 App 的 `aic-diagnostic` 和
  `desktop` profile，使用 Vue Vapor + native core WASM；模拟 UART1 将 write 字节作为
  原始 base64 RX 事件回灌，仍经过 App 的真实 onFrame、桥、合流、日志与文字节点。
- 修复前，两种 profile 都复现 TX/RX=3、RX 显示行为空，冻结时钟用例失败；修复后两种
  profile 均能在后续帧看到 `aaa` 的日志行和真实文字节点。
- 覆盖接收期间时钟回拨、日历消息时间戳来源保留，以及 300 baud 的约 73.3 ms 静默阈值，
  防止通过每帧无条件 flush 改坏原有合流语义。WASM 已存在，未跳过测试。
- `bun test test/`：348 pass / 0 fail，39 文件、2378 次断言。
- `npm run typecheck`、桌面 `npm run check` / `npm run build` 通过。
- `RTT_EXEC_PATH=/Users/kai/DevTools/xpack-riscv-none-elf-gcc-15.2.0-1/bin npm run build:aic`
  通过，包含产品 check/package 和完整固件链接/静态预算检查。

本轮没有连接实际板卡，以上测试不模拟 UART 电气/中断、真实绘制耗时、GC 停顿或 WiFi 负载。
用户反馈已证明旧固件的 3 字节短接回环可返回应用；修复后仍需沿用相同跳线与串口参数复验
孤立 `aaa` 的显示延迟，并在有问题时结合每秒 `turn_max` / `gc_max` 日志区分帧执行耗时。

## 固件

快照位于 `dist/aic/uart-receive-delay-fix/`，包含 `.pocket`、`d12x_os.itb`、完整 `.img`、
ELF、内存报告、构建日志、源码差异、测试文件与 `SHA256SUMS`。

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| pocketcom-aic.pocket | 828184 | `66d1c611657dddfc91085ec1da6eab01476e208d7e12b65f690b5d0995d8f66a` |
| d12x_os.itb | 3000320 | `a667b2f2d8f908208974910b0ccec750ac67ac90b95da81727524186ada69151` |

静态预算：XIP 段 2,973,180 B，CMA 扣双 framebuffer 后 243,780 B，
SW 扣 guest 配额/系统保留后 1,441,792 B，OS 分区余量 145,408 B。
堆/配额、JSON 功能值及 LCD 相位未改；生成的 `AIC_RGB_CLK_CTL=1` 已核对。
